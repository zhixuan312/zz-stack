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
-- absorbs: 002_database_store.sql
-- absorbs: 003_store_data.sql
-- absorbs: 004_envelope_fields.sql
-- absorbs: 005_initiative_record.sql
-- absorbs: 006_revision_presentation.sql
-- absorbs: 007_drop_legacy_store.sql
-- absorbs: 008_comments.sql
-- absorbs: 009_doc_link_cascade.sql
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
-- absorbs: 002_store_carry_repair.sql
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

COMMENT ON TABLE zz.assessment IS 'class=immutable_history; authority=this; question=what the typed service answered to one bounded semantic question, and with what model provenance, for a platform question family or a plugin-eval evaluator version, a reading of unavailable carrying its reason?; retention=kept indefinitely as immutable provenance: no production path deletes a row, and the eval rows that cite it name it by id';


--
-- Name: COLUMN assessment.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.id IS 'class=immutable_history; authority=this; question=what this answer''s identity is, the one eval_assessment cites as its assessment_id?';


--
-- Name: COLUMN assessment.family; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.family IS 'class=immutable_history; authority=this; question=which platform question family asked this question, from the nine names in @zz/contracts, set instead of an evaluator version so that exactly one of the two is non-null?';


--
-- Name: COLUMN assessment.instruction_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.instruction_version IS 'class=immutable_history; authority=this; question=which version of the family instruction asked this question, or which version number of the evaluator asked it, never null?';


--
-- Name: COLUMN assessment.question_digest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.question_digest IS 'class=immutable_history; authority=this; question=which exact question wording this answer belongs to, pinned by its digest?';


--
-- Name: COLUMN assessment.reading; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.reading IS 'class=immutable_history; authority=this; question=what the noul primitive read — yes, no, unclear or unavailable — required whenever a family asked the question?';


--
-- Name: COLUMN assessment.probability; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.probability IS 'class=immutable_history; authority=this; question=what probability the noul primitive put on yes?';


--
-- Name: COLUMN assessment.resolved_model; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.resolved_model IS 'class=immutable_history; authority=this; question=which concrete model the supplier says answered, as distinct from the model that was asked for?';


--
-- Name: COLUMN assessment.identity_assurance; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.identity_assurance IS 'class=immutable_history; authority=this; question=how far the resolved model''s identity is verified, from the contracts'' assurance values?';


--
-- Name: COLUMN assessment.reason; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.reason IS 'class=immutable_history; authority=this; question=why there is no reading, set exactly when the reading is unavailable?';


--
-- Name: COLUMN assessment.about; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.about IS 'class=immutable_history; authority=this; question=what was assessed, an external address such as the store path of the source, which a family row carries and an evaluator row leaves to the consumer that cites it?';


--
-- Name: COLUMN assessment.asked_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.asked_at IS 'class=immutable_history; authority=this; question=when this question was asked, never null?';


--
-- Name: COLUMN assessment.evaluator_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.evaluator_version_id IS 'class=relation; authority=this; question=which plugin-eval evaluator version asked this question, set instead of family so that exactly one of the two is non-null?';


--
-- Name: COLUMN assessment.distribution; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.distribution IS 'class=immutable_history; authority=this; question=what the full answer distribution over the evaluator''s declared options is on a choice or score question, while probability keeps carrying the noul probability?';


--
-- Name: COLUMN assessment.answer_kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.answer_kind IS 'class=immutable_history; authority=this; question=which typed-service primitive answered this question — noul, choice or score — where the default noul exists only so that rows written before migration 077 read as noul unchanged and every writer sets it?';


--
-- Name: COLUMN assessment.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.team_id IS 'class=relation; authority=this; question=which team asked this question, never null, since a family row''s team is otherwise only inferable through a team-scoped slug and an evaluator row''s not at all?';


--
-- Name: COLUMN assessment.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.initiative_id IS 'class=relation; authority=this; question=which initiative asked this question, null on every evaluator row?';


--
-- Name: COLUMN assessment.model_call_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.model_call_id IS 'class=relation; authority=this; question=which model call produced this answer, null when no model was configured and so no call was made?';


--
-- Name: COLUMN assessment.asked_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.asked_by IS 'class=immutable_history; authority=this; question=which principal asked this question, never null?';


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

COMMENT ON TABLE zz.bug IS 'class=current_state; authority=this; question=what did a person report as wrong with the platform, and how was it closed, in the one channel from a user that needs no evidence as knowledge does and has an author as telemetry does not?';


--
-- Name: COLUMN bug.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.id IS 'class=current_state; authority=this; question=what identifies this report?';


--
-- Name: COLUMN bug.reported_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.reported_at IS 'class=current_state; authority=this; question=when was this report filed?';


--
-- Name: COLUMN bug.title; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.title IS 'class=current_state; authority=this; question=what one line names what was reported?';


--
-- Name: COLUMN bug.detail; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.detail IS 'class=current_state; authority=this; question=what happened, in the reporter''s own words?';


--
-- Name: COLUMN bug.surface; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.surface IS 'class=current_state; authority=this; question=which door or tool did the reporter see this on?';


--
-- Name: COLUMN bug.platform_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.platform_version IS 'class=current_state; authority=this; question=which platform release was running when this was reported?';


--
-- Name: COLUMN bug.impact; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.impact IS 'class=current_state; authority=this; question=what did this cost the reporter, from blocked work to a cosmetic defect?';


--
-- Name: COLUMN bug.status; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.status IS 'class=current_state; authority=this; question=where does this report stand: open, fixed, not a bug or a duplicate?';


--
-- Name: COLUMN bug.resolution; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.resolution IS 'class=current_state; authority=this; question=what was decided about this report?';


--
-- Name: COLUMN bug.resolved_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.resolved_at IS 'class=current_state; authority=this; question=when was this report closed?';


--
-- Name: COLUMN bug.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.team_id IS 'class=relation; authority=this; question=which team did the reporter belong to when they filed it?';


--
-- Name: COLUMN bug.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.initiative_id IS 'class=relation; authority=this; question=which initiative was the reporter working on when they filed it?';


--
-- Name: COLUMN bug.duplicate_of; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.duplicate_of IS 'class=current_state; authority=this; question=which earlier report does this one duplicate?';


--
-- Name: COLUMN bug.reported_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.reported_by IS 'class=current_state; authority=this; question=which principal filed this report?';


--
-- Name: COLUMN bug.resolved_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.bug.resolved_by IS 'class=current_state; authority=this; question=which principal closed this report?';


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
-- Name: TABLE candidate; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.candidate IS 'class=state_machine; authority=this; question=which patch was proposed against which exact base plugin version, with what hypothesis and expected effect, and what did its local build and gate say?; transitions=recorded->awaiting_build,awaiting_build->valid,awaiting_build->invalid';


--
-- Name: COLUMN candidate.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.id IS 'class=state_machine; authority=this; question=what is this candidate''s stable identity, the row its release attempts bind to?';


--
-- Name: COLUMN candidate.improvement_run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.improvement_run_id IS 'class=relation; authority=this; question=which improvement attempt proposed it?';


--
-- Name: COLUMN candidate.base_plugin_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.base_plugin_version_id IS 'class=relation; authority=this; question=which exact released plugin version it patches, the baseline it is built and gated against?';


--
-- Name: COLUMN candidate.hypothesis; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.hypothesis IS 'class=state_machine; authority=this; question=what idea does this patch embody, the text whose normalised digest stops a hypothesis already rejected or rolled back from being proposed again?';


--
-- Name: COLUMN candidate.expected_effect; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.expected_effect IS 'class=state_machine; authority=this; question=what is this patch predicted to move, the field FR-36 requires to be recorded with it?';


--
-- Name: COLUMN candidate.patch_digest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.patch_digest IS 'class=state_machine; authority=this; question=what is the sha256 of that diff, the immutable pin an approval and a build both bind to?';


--
-- Name: COLUMN candidate.complexity_delta; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.complexity_delta IS 'class=state_machine; authority=this; question=how much complexity does it add to or remove from its base, the axis a candidate is judged on?';


--
-- Name: COLUMN candidate.touched_components; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.touched_components IS 'class=state_machine; authority=this; question=which of the base version''s components it touches, a snapshot derived against that version''s manifest when the candidate was recorded and needed for display?';


--
-- Name: COLUMN candidate.status; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.status IS 'class=state_machine; authority=this; question=where does it stand in its build lifecycle — recorded, awaiting a build, or judged valid or invalid — given that the attempt''s own states, released and rolled_back, live on release_attempt and a reader joins that row rather than reading a copy here?';


--
-- Name: COLUMN candidate.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.created_at IS 'class=state_machine; authority=this; question=when was it recorded, the moment FR-36 required before anything about the patch could execute?';


--
-- Name: COLUMN candidate.build_requested_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.build_requested_at IS 'class=state_machine; authority=this; question=when did the build lease begin, null until candidate_validate requested a build and cleared again when an expired lease returns the candidate to recorded?';


--
-- Name: COLUMN candidate.build_requested_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.build_requested_by IS 'class=state_machine; authority=this; question=which principal may record its build, the authorization the build rules read, set with the lease and null when no lease stands?';


--
-- Name: COLUMN candidate.build_result; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.build_result IS 'class=state_machine; authority=this; question=what did npm run candidate-build record through candidate_build_record — {ok, stage, log_tail, commands, patch_digest} — kept once candidate_validate consumes it so improvement.md and the console can say how the released patch was built and gated, null before a build lands?';


--
-- Name: COLUMN candidate.build_recorded_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.build_recorded_at IS 'class=state_machine; authority=this; question=when did the build land, the timestamp the candidate''s own build rules read back?';


--
-- Name: COLUMN candidate.patch; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.patch IS 'class=state_machine; authority=this; question=what is the unified diff of it, the exact bytes the digest pins and a release applies?';


--
-- Name: COLUMN candidate.proposed_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.proposed_by IS 'class=state_machine; authority=this; question=which principal proposed it?';


--
-- Name: COLUMN candidate.proposer_client; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.proposer_client IS 'class=state_machine; authority=this; question=which client proposed it, null where the proposer''s identity was not recorded?';


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
-- Name: TABLE console_session; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.console_session IS 'class=current_state; authority=this; question=which browser is signed in as which person, with what lifetime and revocation, issued where and looking at which team?; retention=swept hourly by sweepSessions, which deletes a session 7 days past its expires_at or revoked_at; the sign-in lifetime itself is 12 hours';


--
-- Name: COLUMN console_session.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.id IS 'class=current_state; authority=this; question=what handle identifies this signed-in browser?';


--
-- Name: COLUMN console_session.principal_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.principal_id IS 'class=relation; authority=this; question=whose session is this?';


--
-- Name: COLUMN console_session.token_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.token_hash IS 'class=current_state; authority=this; question=what is the sha256 of this session''s cookie secret?';


--
-- Name: COLUMN console_session.issued_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.issued_at IS 'class=current_state; authority=this; question=when was this browser signed in?';


--
-- Name: COLUMN console_session.expires_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.expires_at IS 'class=current_state; authority=this; question=when does this session end?';


--
-- Name: COLUMN console_session.revoked_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.revoked_at IS 'class=current_state; authority=this; question=when was this session signed out?';


--
-- Name: COLUMN console_session.last_seen_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.last_seen_at IS 'class=current_state; authority=this; question=when did this session last make a request?';


--
-- Name: COLUMN console_session.user_agent; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.user_agent IS 'class=current_state; authority=this; question=which browser was this session issued to?';


--
-- Name: COLUMN console_session.ip; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.ip IS 'class=current_state; authority=this; question=what client address was this session issued from?';


--
-- Name: COLUMN console_session.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.console_session.team_id IS 'class=relation; authority=this; question=which team is this browser looking at?';


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
-- Name: TABLE control_evidence; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.control_evidence IS 'class=immutable_history; authority=this; question=what gate facts was a governed run told, in what order, against which module step, and which earlier entry a later one withdrew?';


--
-- Name: COLUMN control_evidence.seq; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_evidence.seq IS 'class=immutable_history; authority=this; question=in what order were this run''s gate facts appended, the replay order the kernel reads them in?';


--
-- Name: COLUMN control_evidence.run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_evidence.run_id IS 'class=relation; authority=this; question=which governed run was told this fact?';


--
-- Name: COLUMN control_evidence.entry_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_evidence.entry_id IS 'class=immutable_history; authority=this; question=which fact is this — doc:<path>@v<n> for a document version, approval:<path>@v<n> for the version approved, or audit:<source path> — the identity the writer mints once per fact so unique (run_id, entry_id) holds?';


--
-- Name: COLUMN control_evidence.step_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_evidence.step_id IS 'class=immutable_history; authority=this; question=which module step does this fact count for, a snapshot of the module''s vocabulary at record time?';


--
-- Name: COLUMN control_evidence.kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_evidence.kind IS 'class=immutable_history; authority=this; question=is this fact a document write, an approval or an audit source, the fixed vocabulary the kernel branches on?';


--
-- Name: COLUMN control_evidence.about; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_evidence.about IS 'class=immutable_history; authority=this; question=which document path does this document fact concern, or which entry id does this approval or audit fact concern, a same-run reference the writer derives from that path?';


--
-- Name: COLUMN control_evidence.recorded_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_evidence.recorded_at IS 'class=immutable_history; authority=this; question=when was this fact recorded?';


--
-- Name: COLUMN control_evidence.recorded_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_evidence.recorded_by IS 'class=immutable_history; authority=this; question=who recorded this fact, actor text whose values include the adoption script, which is not a principal?';


--
-- Name: COLUMN control_evidence.supersedes; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_evidence.supersedes IS 'class=immutable_history; authority=this; question=which earlier entry of this same run it withdraws, null when none stood, an FK that proves the withdrawal resolves inside the run and to a row that already exists?';


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
-- Name: TABLE control_run; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.control_run IS 'class=current_state; authority=this; question=which initiative is enrolled in the control loop, and which reviewed module body did it enrol under?';


--
-- Name: COLUMN control_run.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_run.id IS 'class=current_state; authority=this; question=what is this run''s durable identity, the row its evidence and waivers hang from and cascade with?';


--
-- Name: COLUMN control_run.module_digest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_run.module_digest IS 'class=current_state; authority=this; question=which module body it enrolled under, the one deliberate historical snapshot whose mismatch with today''s module is what refuses a claim over an unreplayable history?';


--
-- Name: COLUMN control_run.started_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_run.started_at IS 'class=current_state; authority=this; question=when was this initiative enrolled in the control loop?';


--
-- Name: COLUMN control_run.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_run.initiative_id IS 'class=relation; authority=this; question=which initiative it governs, one row per initiative, cascading away with the initiative and sweeping the probe litter that matched none?';


--
-- Name: COLUMN control_run.started_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_run.started_by IS 'class=current_state; authority=this; question=which principal enrolled it, null for the runs enrolled by the adoption script, which is not a principal?';


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
-- Name: TABLE control_waiver; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.control_waiver IS 'class=immutable_history; authority=this; question=which step''s requirement did a person excuse on this run, and on what stated ground, never counting as evidence so the kernel still reports the gap?';


--
-- Name: COLUMN control_waiver.seq; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_waiver.seq IS 'class=immutable_history; authority=this; question=in what order were this run''s waivers recorded?';


--
-- Name: COLUMN control_waiver.run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_waiver.run_id IS 'class=relation; authority=this; question=which governed run is this gap excused within, the run whose module digest pins the rules waived against?';


--
-- Name: COLUMN control_waiver.step_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_waiver.step_id IS 'class=immutable_history; authority=this; question=which module step''s requirement is excused?';


--
-- Name: COLUMN control_waiver.kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_waiver.kind IS 'class=immutable_history; authority=this; question=which requirement kind was excused — document, approval or audit — the same vocabulary evidence uses?';


--
-- Name: COLUMN control_waiver.ground; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_waiver.ground IS 'class=immutable_history; authority=this; question=on what stated ground did a person accept the missing step, never empty and the only place the reason is written down?';


--
-- Name: COLUMN control_waiver.recorded_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_waiver.recorded_at IS 'class=immutable_history; authority=this; question=when was this waiver signed?';


--
-- Name: COLUMN control_waiver.recorded_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.control_waiver.recorded_by IS 'class=immutable_history; authority=this; question=who signed it, actor text whose only value so far is the adoption script, which is not a principal?';


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
    path text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    body_tsv tsvector,
    body text DEFAULT ''::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    initiative_id uuid NOT NULL,
    analyzer_version text,
    current_revision integer,
    approved_revision integer,
    CONSTRAINT doc_status_closed CHECK ((status = ANY (ARRAY[''::text, 'draft'::text, 'approved'::text, 'adopted'::text, 'superseded'::text])))
);


--
-- Name: TABLE doc; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.doc IS 'class=state_machine; authority=this; question=what is this document''s identity and its gate status, as distinct from the revisions it has had?; transitions=draft->approved,approved->draft';


--
-- Name: COLUMN doc.path; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.path IS 'class=state_machine; authority=this; question=where does this document live inside its initiative''s folder?';


--
-- Name: COLUMN doc.type; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.type IS 'class=state_machine; authority=this; question=which role does this document play, an agreement, a plan, a source, or another type its flow declares?';


--
-- Name: COLUMN doc.status; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.status IS 'class=state_machine; authority=this; question=is this document a draft, or approved at its current revision?';


--
-- Name: COLUMN doc.updated_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.updated_at IS 'class=state_machine; authority=this; question=when was this document last written?';


--
-- Name: COLUMN doc.body_tsv; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.body_tsv IS 'class=projection; authority=zz.doc.body; question=what is this document''s body as the search vector a full-text query matches?; rebuilt_from=body';


--
-- Name: COLUMN doc.body; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.body IS 'class=projection; authority=zz.doc_revision.body; question=what does this document''s current revision say?; rebuilt_from=doc_revision[current_revision]';


--
-- Name: COLUMN doc.title; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.title IS 'class=projection; authority=zz.doc_revision.title; question=what is this document''s current revision titled?; rebuilt_from=doc_revision[current_revision]';


--
-- Name: COLUMN doc.tags; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.tags IS 'class=projection; authority=zz.doc_revision.tags; question=which tags does this document''s current revision carry?; rebuilt_from=doc_revision[current_revision]';


--
-- Name: COLUMN doc.content_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.content_hash IS 'class=projection; authority=zz.doc_revision.content_hash; question=what is the hash of this document''s current revision bytes?; rebuilt_from=doc_revision[current_revision]';


--
-- Name: COLUMN doc.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.created_at IS 'class=state_machine; authority=this; question=when did this document first exist, never moved by a later write as updated_at is, and the instant that scopes a measurement to one initiative''s lifetime?';


--
-- Name: COLUMN doc.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.id IS 'class=state_machine; authority=this; question=what is this document''s own identity?';


--
-- Name: COLUMN doc.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.initiative_id IS 'class=relation; authority=this; question=which initiative does this document belong to?';


--
-- Name: COLUMN doc.analyzer_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.analyzer_version IS 'class=projection; authority=zz.doc.body; question=which analyzer generation produced this document''s search vector, so a vector from another generation can be rederived?; rebuilt_from=body';


--
-- Name: COLUMN doc.current_revision; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.current_revision IS 'class=state_machine; authority=this; question=which revision of this document is the current one?';


--
-- Name: COLUMN doc.approved_revision; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.approved_revision IS 'class=state_machine; authority=this; question=which revision of this document was approved last, if any has been?';


--
-- Name: doc_link; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.doc_link (
    from_doc_id uuid NOT NULL,
    from_revision integer NOT NULL,
    to_doc_id uuid NOT NULL,
    to_revision integer,
    kind text NOT NULL,
    CONSTRAINT doc_link_kind_check CHECK ((kind = ANY (ARRAY['cites'::text, 'supports'::text]))),
    CONSTRAINT doc_link_revision_shape CHECK ((((kind = 'cites'::text) AND (to_revision IS NOT NULL)) OR ((kind = 'supports'::text) AND (to_revision IS NULL))))
);


--
-- Name: TABLE doc_link; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.doc_link IS 'class=relation; authority=this; question=which exact revision cites which other exact revision, or which source revision supports which document identity across its later revisions?';


--
-- Name: COLUMN doc_link.from_doc_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_link.from_doc_id IS 'class=relation; authority=this; question=which document does the citing or supporting revision belong to?';


--
-- Name: COLUMN doc_link.from_revision; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_link.from_revision IS 'class=relation; authority=this; question=which exact revision of that document does the citing or supporting?';


--
-- Name: COLUMN doc_link.to_doc_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_link.to_doc_id IS 'class=relation; authority=this; question=which document is cited, or supported?';


--
-- Name: COLUMN doc_link.to_revision; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_link.to_revision IS 'class=relation; authority=this; question=which exact revision is cited, null when only the target document''s identity is supported?';


--
-- Name: COLUMN doc_link.kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_link.kind IS 'class=relation; authority=this; question=is this a citation of one exact revision by another, or a source revision''s support for a document identity?';


--
-- Name: doc_revision; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.doc_revision (
    doc_id uuid NOT NULL,
    revision integer NOT NULL,
    content_state text NOT NULL,
    title text,
    body text,
    tags text[],
    content_hash text,
    written_by uuid,
    written_at timestamp with time zone,
    revision_note text,
    approved_by uuid,
    approved_at timestamp with time zone,
    fields jsonb,
    presented_at timestamp with time zone,
    CONSTRAINT doc_revision_approval_paired CHECK (((approved_by IS NULL) = (approved_at IS NULL))),
    CONSTRAINT doc_revision_content_state_check CHECK ((content_state = ANY (ARRAY['retained'::text, 'missing_legacy'::text]))),
    CONSTRAINT doc_revision_evidence_required CHECK ((((content_state = 'retained'::text) AND (title IS NOT NULL) AND (body IS NOT NULL) AND (tags IS NOT NULL) AND (content_hash IS NOT NULL)) OR ((content_state = 'missing_legacy'::text) AND (title IS NULL) AND (body IS NULL) AND (tags IS NULL) AND (content_hash IS NULL)))),
    CONSTRAINT doc_revision_missing_legacy_terminal CHECK (((content_state <> 'missing_legacy'::text) OR ((approved_by IS NULL) AND (approved_at IS NULL))))
);


--
-- Name: TABLE doc_revision; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.doc_revision IS 'class=state_machine; authority=this; question=which revision of this document is this, and does it still retain the exact bytes that were written?; transitions=written->approved';


--
-- Name: COLUMN doc_revision.doc_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.doc_id IS 'class=relation; authority=this; question=which document does this revision belong to?';


--
-- Name: COLUMN doc_revision.revision; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.revision IS 'class=state_machine; authority=this; question=which revision number of that document is this?';


--
-- Name: COLUMN doc_revision.content_state; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.content_state IS 'class=state_machine; authority=this; question=does this revision still retain the exact bytes that were written, or is it a revision known to have existed whose bytes were overwritten before any approval snapshot?';


--
-- Name: COLUMN doc_revision.title; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.title IS 'class=state_machine; authority=this; question=what was this revision titled?';


--
-- Name: COLUMN doc_revision.body; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.body IS 'class=state_machine; authority=this; question=what did this revision say?';


--
-- Name: COLUMN doc_revision.tags; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.tags IS 'class=state_machine; authority=this; question=which tags did this revision carry?';


--
-- Name: COLUMN doc_revision.content_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.content_hash IS 'class=state_machine; authority=this; question=what is the hash of this revision''s bytes?';


--
-- Name: COLUMN doc_revision.written_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.written_by IS 'class=state_machine; authority=this; question=which principal wrote this revision?';


--
-- Name: COLUMN doc_revision.written_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.written_at IS 'class=state_machine; authority=this; question=when was this revision written?';


--
-- Name: COLUMN doc_revision.revision_note; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.revision_note IS 'class=state_machine; authority=this; question=what one line did the writer record about why this revision changed?';


--
-- Name: COLUMN doc_revision.approved_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.approved_by IS 'class=state_machine; authority=this; question=which principal approved these exact bytes, if they have been approved?';


--
-- Name: COLUMN doc_revision.approved_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.approved_at IS 'class=state_machine; authority=this; question=when were these exact bytes approved, if they have been?';


--
-- Name: COLUMN doc_revision.fields; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.fields IS 'class=state_machine; authority=this; question=which envelope fields does this revision carry that have no column of their own?';


--
-- Name: COLUMN doc_revision.presented_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc_revision.presented_at IS 'class=state_machine; authority=this; question=when were these exact bytes put in front of a person, the fact document_approve is refused by and a column rather than a sweepable event row so an approval gate cannot fail open?';


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
-- Name: TABLE eval_assessment; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_assessment IS 'class=immutable_history; authority=this; question=in one evaluation, what did one measure answer about one subject, or why was it excluded from the score?';


--
-- Name: COLUMN eval_assessment.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.id IS 'class=immutable_history; authority=this; question=what is this assessment row''s own identity, the id a finding cites as its reading?';


--
-- Name: COLUMN eval_assessment.eval_run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.eval_run_id IS 'class=relation; authority=this; question=which evaluation''s score reduced this answer?';


--
-- Name: COLUMN eval_assessment.measure_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.measure_id IS 'class=relation; authority=this; question=which measure of the run''s protocol version was answered here?';


--
-- Name: COLUMN eval_assessment.assessment_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.assessment_id IS 'class=relation; authority=this; question=which stored model answer in zz.assessment backed this measurement, null where the measure called no model?';


--
-- Name: COLUMN eval_assessment.qualification_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.qualification_id IS 'class=relation; authority=this; question=which evaluator qualification was in force when this answer was taken or skipped?';


--
-- Name: COLUMN eval_assessment.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.created_at IS 'class=immutable_history; authority=this; question=when was this answer recorded?';


--
-- Name: COLUMN eval_assessment.subject_kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.subject_kind IS 'class=immutable_history; authority=this; question=what kind of subject this answer is about — run_level, meaning the parent run''s own observation snapshot and no child key at all, or run named by run_id, document by doc_id and doc_revision, knowledge by knowledge_node_id, bug by bug_id, or event by event_id?';


--
-- Name: COLUMN eval_assessment.run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.run_id IS 'class=relation; authority=this; question=which skill run was judged, when the subject kind is run?';


--
-- Name: COLUMN eval_assessment.doc_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.doc_id IS 'class=relation; authority=this; question=which document was judged, when the subject kind is document?';


--
-- Name: COLUMN eval_assessment.doc_revision; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.doc_revision IS 'class=immutable_history; authority=this; question=which revision of that document pins the exact bytes judged, left null only on a legacy document subject whose revision cannot be reconstructed?';


--
-- Name: COLUMN eval_assessment.knowledge_node_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.knowledge_node_id IS 'class=relation; authority=this; question=which knowledge node was judged, when the subject kind is knowledge?';


--
-- Name: COLUMN eval_assessment.bug_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.bug_id IS 'class=relation; authority=this; question=which bug report was judged, when the subject kind is bug?';


--
-- Name: COLUMN eval_assessment.event_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.event_id IS 'class=relation; authority=this; question=which recorded event was judged, when the subject kind is event?';


--
-- Name: COLUMN eval_assessment.value; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.value IS 'class=immutable_history; authority=this; question=what value the measure returned for this subject, null exactly when the answer was excluded?';


--
-- Name: COLUMN eval_assessment.raw_value; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.raw_value IS 'class=immutable_history; authority=this; question=what the measure''s own unreduced reading was, kept so a reader can see past the reduced value?';


--
-- Name: COLUMN eval_assessment.numerator; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.numerator IS 'class=immutable_history; authority=this; question=what numerator the measure counted, when its answer was a rate rather than a single reading?';


--
-- Name: COLUMN eval_assessment.denominator; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.denominator IS 'class=immutable_history; authority=this; question=what denominator that rate was counted over?';


--
-- Name: COLUMN eval_assessment.excluded_reason; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_assessment.excluded_reason IS 'class=immutable_history; authority=this; question=why this measure was excluded from the score rather than answering, set exactly when value is null?';


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
-- Name: TABLE eval_dimension; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_dimension IS 'class=immutable_history; authority=this; question=within one protocol version, which canonical meaning counts, with what weight, whether it is required for establishment, and whether it is applicable at all?';


--
-- Name: COLUMN eval_dimension.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_dimension.id IS 'class=immutable_history; authority=this; question=which dimension does a measure, or a per-run dimension score, belong to?';


--
-- Name: COLUMN eval_dimension.protocol_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_dimension.protocol_version_id IS 'class=relation; authority=this; question=which protocol version does this dimension belong to?';


--
-- Name: COLUMN eval_dimension.key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_dimension.key IS 'class=immutable_history; authority=this; question=what does this protocol call this dimension, the name its measures and the dashboard cite it by?';


--
-- Name: COLUMN eval_dimension.canonical_kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_dimension.canonical_kind IS 'class=immutable_history; authority=this; question=which of the six canonical evaluation meanings does this dimension measure?';


--
-- Name: COLUMN eval_dimension.weight; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_dimension.weight IS 'class=immutable_history; authority=this; question=how much of the version''s weighted sum does this dimension carry?';


--
-- Name: COLUMN eval_dimension.required; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_dimension.required IS 'class=immutable_history; authority=this; question=must this dimension be established for the score to count under this version?';


--
-- Name: COLUMN eval_dimension.applicable; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_dimension.applicable IS 'class=immutable_history; authority=this; question=does this dimension apply to this protocol''s subjects, or was it declared out of scope?';


--
-- Name: COLUMN eval_dimension.not_applicable_reason; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_dimension.not_applicable_reason IS 'class=immutable_history; authority=this; question=why was this dimension declared not applicable, the rationale the check pairs with the flag?';


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
-- Name: TABLE eval_evaluator_qualification; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_evaluator_qualification IS 'class=immutable_history; authority=this; question=was measure M''s evaluator found to be qualified at state S, on what evidence, by whom and when, with the latest row winning?';


--
-- Name: COLUMN eval_evaluator_qualification.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_qualification.id IS 'class=immutable_history; authority=this; question=which qualification row does an assessment cite as the rung in force when its answer was taken or skipped?';


--
-- Name: COLUMN eval_evaluator_qualification.state; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_qualification.state IS 'class=immutable_history; authority=this; question=at which qualification rung did this run find the measure''s evaluator?';


--
-- Name: COLUMN eval_evaluator_qualification.evidence; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_qualification.evidence IS 'class=immutable_history; authority=this; question=what anchor, planted-fault, control, stability and label counts did this qualification run produce, each result carrying the assessment id behind it?';


--
-- Name: COLUMN eval_evaluator_qualification.qualified_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_qualification.qualified_at IS 'class=immutable_history; authority=this; question=when was this qualification recorded, the timestamp that decides which row is latest?';


--
-- Name: COLUMN eval_evaluator_qualification.measure_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_qualification.measure_id IS 'class=relation; authority=this; question=which measure''s known-answer anchors were run?';


--
-- Name: COLUMN eval_evaluator_qualification.qualified_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_qualification.qualified_by IS 'class=immutable_history; authority=this; question=which principal ran this qualification?';


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
-- Name: TABLE eval_evaluator_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_evaluator_version IS 'class=immutable_history; authority=this; question=what is the frozen wording and answer shape of one semantic question at version N, the exact question every assessment of it names?';


--
-- Name: COLUMN eval_evaluator_version.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_version.id IS 'class=immutable_history; authority=this; question=which evaluator version does an assessment name as the exact question it was answered with?';


--
-- Name: COLUMN eval_evaluator_version.version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_version.version IS 'class=immutable_history; authority=this; question=which ordinal is this version of the evaluator under its stable key?';


--
-- Name: COLUMN eval_evaluator_version.question; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_version.question IS 'class=immutable_history; authority=this; question=what instruction text does this evaluator version ask, the wording a model call must be shown verbatim?';


--
-- Name: COLUMN eval_evaluator_version.answer_schema; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_version.answer_schema IS 'class=immutable_history; authority=this; question=what answer shape does this evaluator return — a noul, choice or score type, with its criteria map — so a reader can parse what the model said?';


--
-- Name: COLUMN eval_evaluator_version.positive_answer; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_version.positive_answer IS 'class=immutable_history; authority=this; question=which answer counts as the good one, the polarity the reducer reads, null where the evaluator has no good side?';


--
-- Name: COLUMN eval_evaluator_version.content_digest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_version.content_digest IS 'class=immutable_history; authority=this; question=what is the sha256 of the question, answer schema and positive answer, the digest an unchanged wording is reused by?';


--
-- Name: COLUMN eval_evaluator_version.stable_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_evaluator_version.stable_key IS 'class=immutable_history; authority=this; question=what is this evaluator''s identity across versions, by convention prefixed with the owning plugin?';


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
-- Name: TABLE eval_failure_mode; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_failure_mode IS 'class=current_state; authority=this; question=which distinct failure modes does one plugin have, one row per stable key, with what canonical description?';


--
-- Name: COLUMN eval_failure_mode.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode.id IS 'class=current_state; authority=this; question=which failure mode do its sightings and the protocol versions that fold it in point at?';


--
-- Name: COLUMN eval_failure_mode.plugin_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode.plugin_id IS 'class=relation; authority=this; question=which plugin does this failure mode belong to?';


--
-- Name: COLUMN eval_failure_mode.stable_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode.stable_key IS 'class=current_state; authority=this; question=what identifies this failure mode within its plugin — the failing tool and refusal rule, or the two stages of a return?';


--
-- Name: COLUMN eval_failure_mode.description; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode.description IS 'class=current_state; authority=this; question=what is the canonical description of this failure mode, as distinct from what one sighting counted?';


--
-- Name: COLUMN eval_failure_mode.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode.created_at IS 'class=current_state; authority=this; question=when was this failure mode first identified?';


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
-- Name: TABLE eval_failure_mode_sighting; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_failure_mode_sighting IS 'class=immutable_history; authority=this; question=what one failure mode was found to look like in one observation snapshot, how prevalent it was, and who it is owned by?; retention=bounded by the observation snapshots it is discovered against; append-only with no sweep, and a sighting is never deleted or rewritten';


--
-- Name: COLUMN eval_failure_mode_sighting.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.id IS 'class=immutable_history; authority=this; question=which sighting is this, the row its evidence and provenance hang from?';


--
-- Name: COLUMN eval_failure_mode_sighting.failure_mode_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.failure_mode_id IS 'class=relation; authority=this; question=which failure mode is this a sighting of?';


--
-- Name: COLUMN eval_failure_mode_sighting.observation_snapshot_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.observation_snapshot_id IS 'class=relation; authority=this; question=in which observation snapshot was this failure mode seen?';


--
-- Name: COLUMN eval_failure_mode_sighting.description; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.description IS 'class=immutable_history; authority=this; question=how was this failure mode described in this sighting, including the counts it was seen with?';


--
-- Name: COLUMN eval_failure_mode_sighting.prevalence_numerator; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.prevalence_numerator IS 'class=immutable_history; authority=this; question=in how many groups of this snapshot was the failure mode seen?';


--
-- Name: COLUMN eval_failure_mode_sighting.prevalence_denominator; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.prevalence_denominator IS 'class=immutable_history; authority=this; question=how many groups were there to see it in, so the rate can be re-derived rather than trusted?';


--
-- Name: COLUMN eval_failure_mode_sighting.owner_kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.owner_kind IS 'class=immutable_history; authority=this; question=which party does this sighting blame — the plugin, a dependency, the platform, the environment, user input or unknown?';


--
-- Name: COLUMN eval_failure_mode_sighting.owner_ref; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.owner_ref IS 'class=immutable_history; authority=this; question=which named owner does this sighting point at, where one is known?';


--
-- Name: COLUMN eval_failure_mode_sighting.ownership_reason; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.ownership_reason IS 'class=immutable_history; authority=this; question=why was this ownership classification reached, especially where it is unknown?';


--
-- Name: COLUMN eval_failure_mode_sighting.confidence; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.confidence IS 'class=immutable_history; authority=this; question=how confident was the ownership classifier in this sighting?';


--
-- Name: COLUMN eval_failure_mode_sighting.assessment_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.assessment_id IS 'class=relation; authority=this; question=which model answer behind this ownership classification can be read?';


--
-- Name: COLUMN eval_failure_mode_sighting.description_model_call_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.description_model_call_id IS 'class=relation; authority=this; question=which generative-critic model call wrote this description?';


--
-- Name: COLUMN eval_failure_mode_sighting.evidence_refs; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.evidence_refs IS 'class=immutable_history; authority=this; question=which representative events and initiatives are the evidence for this sighting?';


--
-- Name: COLUMN eval_failure_mode_sighting.discovered_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.discovered_by IS 'class=immutable_history; authority=this; question=which principal''s DISCOVER call found this sighting?';


--
-- Name: COLUMN eval_failure_mode_sighting.discovery_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.discovery_key IS 'class=immutable_history; authority=this; question=under which idempotency key was this sighting written, so a replayed DISCOVER call recovers its own rows?';


--
-- Name: COLUMN eval_failure_mode_sighting.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_failure_mode_sighting.created_at IS 'class=immutable_history; authority=this; question=when was this sighting recorded?';


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
-- Name: TABLE eval_finding; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_finding IS 'class=state_machine; authority=this; question=what conclusion did one evaluation run reach about a plugin, whose problem it names, and whether that owner has since applied or rejected the fix?; transitions=deferred->applied,deferred->rejected';


--
-- Name: COLUMN eval_finding.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.id IS 'class=state_machine; authority=this; question=what is this finding''s stable identity, the row a correction and every decision hang from?';


--
-- Name: COLUMN eval_finding.pattern; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.pattern IS 'class=state_machine; authority=this; question=what did the run find, in the one sentence findings.md and the proposal document print?';


--
-- Name: COLUMN eval_finding.decision; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.decision IS 'class=state_machine; authority=this; question=has the owner applied or rejected it — deferred while it is open, and null for a strength, which is not open work?';


--
-- Name: COLUMN eval_finding.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.created_at IS 'class=state_machine; authority=this; question=when was it recorded, the order the documents print it in?';


--
-- Name: COLUMN eval_finding.decided_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.decided_at IS 'class=state_machine; authority=this; question=when was it applied or rejected?';


--
-- Name: COLUMN eval_finding.decision_note; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.decision_note IS 'class=state_machine; authority=this; question=why was it applied or rejected — for the 21 applied rows this prose is the only record of which release carried the fix, and it is empty while deferred, since the open state needs no reason and the two closed ones do?';


--
-- Name: COLUMN eval_finding.owner_kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.owner_kind IS 'class=state_machine; authority=this; question=whose problem is it — the plugin''s, a dependency''s, the platform''s, the environment''s, the user''s input, or unknown?';


--
-- Name: COLUMN eval_finding.owner_ref; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.owner_ref IS 'class=state_machine; authority=this; question=which owner exactly, free prose for a platform, dependency or environment owner and always null when owner_kind is plugin, whose plugin is already reached through the run?';


--
-- Name: COLUMN eval_finding.measure_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.measure_id IS 'class=relation; authority=this; question=which measure of the run''s protocol does it evidence, null when it evidences no single measure?';


--
-- Name: COLUMN eval_finding.evidence_refs; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.evidence_refs IS 'class=state_machine; authority=this; question=which typed references — an observation snapshot, an assessment, a document path — ground its claim, an open list by design?';


--
-- Name: COLUMN eval_finding.expected_effect; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.expected_effect IS 'class=state_machine; authority=this; question=what movement does the fix it asks for expect, null wherever the finding is not a plugin-owned defect?';


--
-- Name: COLUMN eval_finding.eval_run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.eval_run_id IS 'class=relation; authority=this; question=which evaluation run concluded it, the parent every current reader filters by, finding_record writing one on every finding since the legacy round column it shared this table with went with the round tables?';


--
-- Name: COLUMN eval_finding.kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.kind IS 'class=state_machine; authority=this; question=is it a strength, a defect or an unknown, the fact that decides whether it is open work at all, a strength being terminal at insert with a null decision?';


--
-- Name: COLUMN eval_finding.superseded_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.superseded_by IS 'class=state_machine; authority=this; question=which later finding of the same run corrected it, null for a current one, a superseded finding also being decision=rejected so it stays closed for every reader?';


--
-- Name: COLUMN eval_finding.decided_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.decided_by IS 'class=state_machine; authority=this; question=which principal applied or rejected it?';


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
-- Name: TABLE eval_idempotency; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_idempotency IS 'class=ephemeral; authority=this; question=has this caller already made this call with this key, and which row did the first one produce?; retention=declared 30 days: past that age an entry is replay-dead, and no production path deletes one yet';


--
-- Name: COLUMN eval_idempotency.tool; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_idempotency.tool IS 'class=ephemeral; authority=this; question=which mutating tool call is this retry ledger entry for?';


--
-- Name: COLUMN eval_idempotency.idempotency_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_idempotency.idempotency_key IS 'class=ephemeral; authority=this; question=what key did the caller give this attempt, unique within the tool for that principal?';


--
-- Name: COLUMN eval_idempotency.request_digest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_idempotency.request_digest IS 'class=ephemeral; authority=this; question=what digest of the canonical arguments this call was made with, so a same-key call with different arguments is refused?';


--
-- Name: COLUMN eval_idempotency.result_table; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_idempotency.result_table IS 'class=ephemeral; authority=this; question=which table the first write landed in, naming a parent table where the call produced no single result row?';


--
-- Name: COLUMN eval_idempotency.result_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_idempotency.result_id IS 'class=ephemeral; authority=this; question=which row the first write produced, a polymorphic pointer with no foreign key because it may name any result table?';


--
-- Name: COLUMN eval_idempotency.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_idempotency.created_at IS 'class=ephemeral; authority=this; question=when the first write was recorded, the instant the 30-day sweep measures from?';


--
-- Name: COLUMN eval_idempotency.principal_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_idempotency.principal_id IS 'class=relation; authority=this; question=which principal made the call, the first component of the key rather than an address that can change?';


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
-- Name: TABLE eval_measure; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_measure IS 'class=immutable_history; authority=this; question=within a dimension of one protocol version, which measure is answered by which evaluator mechanism, with what weight, and read by what rule?';


--
-- Name: COLUMN eval_measure.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.id IS 'class=immutable_history; authority=this; question=which measure does an assessment, a finding or a qualification name?';


--
-- Name: COLUMN eval_measure.dimension_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.dimension_id IS 'class=relation; authority=this; question=which dimension of the version does this measure belong to?';


--
-- Name: COLUMN eval_measure.key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.key IS 'class=immutable_history; authority=this; question=what is this measure''s name within its protocol version, the key findings, guardrails and qualification all cite?';


--
-- Name: COLUMN eval_measure.evaluator_type; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.evaluator_type IS 'class=immutable_history; authority=this; question=which mechanism answers this measure — a stored fact, a recorded outcome, a bounded semantic question, a generative critic or a human?';


--
-- Name: COLUMN eval_measure.weight; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.weight IS 'class=immutable_history; authority=this; question=how much of its dimension''s weighted sum does this measure carry?';


--
-- Name: COLUMN eval_measure.required; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.required IS 'class=immutable_history; authority=this; question=must this measure be answered for its dimension to be established?';


--
-- Name: COLUMN eval_measure.definition; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.definition IS 'class=immutable_history; authority=this; question=how is this measure read — the normalisation, maximum, applicability rule, documents, whole-document flag and qualification anchors that stay per-mechanism — now that the fact path, subject kind and positive answer live in columns?';


--
-- Name: COLUMN eval_measure.evaluator_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.evaluator_version_id IS 'class=relation; authority=this; question=which frozen semantic question backs this model-driven measure?';


--
-- Name: COLUMN eval_measure.protocol_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.protocol_version_id IS 'class=relation; authority=this; question=which protocol version does this measure belong to, denormalised so its key is unique within the version and the composite key to its dimension is expressible?';


--
-- Name: COLUMN eval_measure.fact_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.fact_key IS 'class=immutable_history; authority=this; question=which observation fact does this deterministic or outcome measure read?';


--
-- Name: COLUMN eval_measure.subject_kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.subject_kind IS 'class=immutable_history; authority=this; question=which kind of reference does this model-backed measure judge — a run, a document, a knowledge node, a bug or an event?';


--
-- Name: COLUMN eval_measure.guardrail_threshold; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_measure.guardrail_threshold IS 'class=immutable_history; authority=this; question=above what reduced value does this measure fail as a critical, non-compensatory guardrail?';


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
-- Name: TABLE eval_observation_snapshot; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_observation_snapshot IS 'class=immutable_history; authority=this; question=what did one plugin release''s real runs look like in one resolved window, with the facts computed from them and the denominators those rates carry?';


--
-- Name: COLUMN eval_observation_snapshot.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.id IS 'class=immutable_history; authority=this; question=which snapshot do evaluation runs, findings and failure-mode sightings name as their evidence?';


--
-- Name: COLUMN eval_observation_snapshot.usable_run_count; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.usable_run_count IS 'class=immutable_history; authority=this; question=how many runs in the window count as usable evidence?';


--
-- Name: COLUMN eval_observation_snapshot.total_run_count; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.total_run_count IS 'class=immutable_history; authority=this; question=how many runs fell in the window at all, the denominator a minimum-runs rule is read against?';


--
-- Name: COLUMN eval_observation_snapshot.evidence_digest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.evidence_digest IS 'class=immutable_history; authority=this; question=what is the sha256 of this snapshot''s canonical facts, the value a recompute is compared against to report drift?';


--
-- Name: COLUMN eval_observation_snapshot.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.created_at IS 'class=immutable_history; authority=this; question=when was this snapshot captured?';


--
-- Name: COLUMN eval_observation_snapshot.facts; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.facts IS 'class=immutable_history; authority=this; question=which facts did computeObservation write for this snapshot — every ObservedFact of observe-facts.ts''s OBSERVATION_FACT_KEYS, keyed by fact name, one entry of which a deterministic or outcome measure reads by its dotted definition.factPath — and is it null when the snapshot carries no computed facts, every such measure then answering excluded with a named reason?';


--
-- Name: COLUMN eval_observation_snapshot.plugin_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.plugin_version_id IS 'class=relation; authority=this; question=which released plugin version was observed?';


--
-- Name: COLUMN eval_observation_snapshot.window_from; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.window_from IS 'class=immutable_history; authority=this; question=from when does the observed window open, null when no window was resolved?';


--
-- Name: COLUMN eval_observation_snapshot.window_to; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.window_to IS 'class=immutable_history; authority=this; question=until when does the observed window run, null when no window was resolved?';


--
-- Name: COLUMN eval_observation_snapshot.surface_observed; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.surface_observed IS 'class=immutable_history; authority=this; question=how many of the plugin''s declared tool surfaces did the window actually observe?';


--
-- Name: COLUMN eval_observation_snapshot.surface_total; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.surface_total IS 'class=immutable_history; authority=this; question=how many surfaces were there to observe?';


--
-- Name: COLUMN eval_observation_snapshot.surface_source; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.surface_source IS 'class=immutable_history; authority=this; question=where did the surface total come from, so a coverage figure can be trusted?';


--
-- Name: COLUMN eval_observation_snapshot.platform_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.platform_version IS 'class=immutable_history; authority=this; question=which platform build produced this observation?';


--
-- Name: COLUMN eval_observation_snapshot.recorded_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.recorded_by IS 'class=immutable_history; authority=this; question=which principal ran this observation?';


--
-- Name: eval_protocol_failure_mode; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_protocol_failure_mode (
    protocol_version_id uuid NOT NULL,
    failure_mode_id uuid NOT NULL
);


--
-- Name: TABLE eval_protocol_failure_mode; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_protocol_failure_mode IS 'class=relation; authority=this; question=which failure modes does one protocol version fold into its lineage?';


--
-- Name: COLUMN eval_protocol_failure_mode.protocol_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_failure_mode.protocol_version_id IS 'class=relation; authority=this; question=which protocol version folds in this failure mode?';


--
-- Name: COLUMN eval_protocol_failure_mode.failure_mode_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_failure_mode.failure_mode_id IS 'class=relation; authority=this; question=which failure mode does this protocol version fold in?';


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
    approved_doc_revision integer,
    CONSTRAINT eval_protocol_version_affirmation_check CHECK ((((approved_doc_id IS NULL) = (affirmed_by IS NULL)) AND ((approved_doc_id IS NULL) = (affirmed_at IS NULL))))
);


--
-- Name: TABLE eval_protocol_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_protocol_version IS 'class=state_machine; authority=this; question=what frozen, immutable definition of good does one plugin have at protocol version N, and has an approved protocol.md been bound to it yet?; transitions=recorded->affirmed';


--
-- Name: COLUMN eval_protocol_version.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.id IS 'class=state_machine; authority=this; question=which protocol version does every dimension, measure, document binding and published score name as the definition it was produced under?';


--
-- Name: COLUMN eval_protocol_version.version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.version IS 'class=state_machine; authority=this; question=which ordinal is this version of the lineage, the number whose successor refuses to reuse it?';


--
-- Name: COLUMN eval_protocol_version.purpose; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.purpose IS 'class=state_machine; authority=this; question=which plugin purpose does this version measure against, the text whose change makes the version stale?';


--
-- Name: COLUMN eval_protocol_version.qualification_policy; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.qualification_policy IS 'class=state_machine; authority=this; question=which thresholds and minimum qualification rung must an evaluator clear before its answers may back a score under this version?';


--
-- Name: COLUMN eval_protocol_version.scoring_policy; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.scoring_policy IS 'class=state_machine; authority=this; question=which establishment rules, such as bootstrap and minimum measure coverage, and which uncertainty settings does scoring under this version follow?';


--
-- Name: COLUMN eval_protocol_version.improvement_policy; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.improvement_policy IS 'class=state_machine; authority=this; question=what release policy does this version apply, now that the critical guardrails have moved onto the measures and evolvable has been dropped?';


--
-- Name: COLUMN eval_protocol_version.content_digest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.content_digest IS 'class=state_machine; authority=this; question=what is the sha256 of this version''s canonical body, the digest an approved protocol.md must quote before the version may be affirmed?';


--
-- Name: COLUMN eval_protocol_version.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.created_at IS 'class=state_machine; authority=this; question=when was this protocol version recorded?';


--
-- Name: COLUMN eval_protocol_version.plugin_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.plugin_id IS 'class=relation; authority=this; question=which plugin is this protocol version for?';


--
-- Name: COLUMN eval_protocol_version.protocol_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.protocol_key IS 'class=state_machine; authority=this; question=what is the lineage''s display name, shown next to the version number?';


--
-- Name: COLUMN eval_protocol_version.observable_surfaces; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.observable_surfaces IS 'class=state_machine; authority=this; question=which tool and evidence surfaces does this version cover, so a surface outside the set counts as new evidence and forces a new version?';


--
-- Name: COLUMN eval_protocol_version.approved_doc_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.approved_doc_id IS 'class=relation; authority=this; question=which approved protocol.md document is bound to this version?';


--
-- Name: COLUMN eval_protocol_version.affirmed_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.affirmed_by IS 'class=state_machine; authority=this; question=which principal affirmed this version by binding the approved document?';


--
-- Name: COLUMN eval_protocol_version.affirmed_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.affirmed_at IS 'class=state_machine; authority=this; question=when was this version affirmed?';


--
-- Name: COLUMN eval_protocol_version.recorded_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.recorded_by IS 'class=state_machine; authority=this; question=which principal recorded this version?';


--
-- Name: COLUMN eval_protocol_version.approved_doc_revision; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_protocol_version.approved_doc_revision IS 'class=state_machine; authority=this; question=which revision of the approved protocol.md was affirmed, so the binding names exact bytes rather than a document that may have moved since?';


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
-- Name: TABLE eval_run; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_run IS 'class=state_machine; authority=this; question=which evaluation bound one protocol version to one observation snapshot, and what score, status, guardrail verdict and uncertainty did it publish?; transitions=created->scored';


--
-- Name: COLUMN eval_run.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.id IS 'class=state_machine; authority=this; question=what is this evaluation run''s stable identity, the handle its assessments, findings, improvements and release verdicts hang off?';


--
-- Name: COLUMN eval_run.protocol_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.protocol_version_id IS 'class=relation; authority=this; question=which protocol version, with its dimensions and measures, did this run score against?';


--
-- Name: COLUMN eval_run.score_status; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.score_status IS 'class=state_machine; authority=this; question=is this run''s published score established, provisional or not_established, and null only while the run has not been scored?';


--
-- Name: COLUMN eval_run.overall_score; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.overall_score IS 'class=state_machine; authority=this; question=what score between 0 and 10 did this run publish?';


--
-- Name: COLUMN eval_run.guardrail_status; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.guardrail_status IS 'class=state_machine; authority=this; question=did this run''s critical guardrails pass or fail, or come back not_established?';


--
-- Name: COLUMN eval_run.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.created_at IS 'class=state_machine; authority=this; question=when was this run started?';


--
-- Name: COLUMN eval_run.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.team_id IS 'class=relation; authority=this; question=which team ran this evaluation, whose documents its document subjects were resolved against and which the named initiative must belong to?';


--
-- Name: COLUMN eval_run.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.initiative_id IS 'class=relation; authority=this; question=which initiative ran this evaluation, when it was started from one?';


--
-- Name: COLUMN eval_run.observation_snapshot_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.observation_snapshot_id IS 'class=relation; authority=this; question=which observation snapshot of real production use was this run scored against?';


--
-- Name: COLUMN eval_run.score_lower; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.score_lower IS 'class=state_machine; authority=this; question=what is the lower bound of this run''s published uncertainty interval?';


--
-- Name: COLUMN eval_run.score_upper; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.score_upper IS 'class=state_machine; authority=this; question=what is the upper bound of this run''s published uncertainty interval?';


--
-- Name: COLUMN eval_run.measure_coverage; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.measure_coverage IS 'class=state_machine; authority=this; question=what share of the protocol''s declared measure weight this run actually scored?';


--
-- Name: COLUMN eval_run.establishment_blocked_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.establishment_blocked_by IS 'class=state_machine; authority=this; question=which reasons stopped this run''s score from being established, each named by the policy that failed?';


--
-- Name: COLUMN eval_run.scorer_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.scorer_version IS 'class=state_machine; authority=this; question=which platform version''s scoring code produced this published result, so a recompute under newer code cannot silently move the comparison a rollback turns on?';


--
-- Name: COLUMN eval_run.started_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.started_by IS 'class=state_machine; authority=this; question=which principal started this run?';


--
-- Name: COLUMN eval_run.scored_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run.scored_at IS 'class=state_machine; authority=this; question=when was this run''s result published, the terminal marker that closes it against every later re-scoring?';


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
-- Name: TABLE eval_run_dimension; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.eval_run_dimension IS 'class=immutable_history; authority=this; question=what score and coverage did one scored run publish for one dimension of its protocol?';


--
-- Name: COLUMN eval_run_dimension.eval_run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run_dimension.eval_run_id IS 'class=relation; authority=this; question=which scored run published this per-dimension result?';


--
-- Name: COLUMN eval_run_dimension.protocol_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run_dimension.protocol_version_id IS 'class=relation; authority=this; question=which protocol version do both the run and the dimension this row joins belong to, the shared key that keeps them from disagreeing?';


--
-- Name: COLUMN eval_run_dimension.dimension_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run_dimension.dimension_id IS 'class=relation; authority=this; question=which declared dimension of that protocol version does this score belong to?';


--
-- Name: COLUMN eval_run_dimension.score; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run_dimension.score IS 'class=immutable_history; authority=this; question=what score between 0 and 10 did the run publish for this dimension, null when the dimension did not apply?';


--
-- Name: COLUMN eval_run_dimension.coverage; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_run_dimension.coverage IS 'class=immutable_history; authority=this; question=what share of this dimension''s declared measure weight was scored, null when it was not measured?';


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
-- Name: TABLE event; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.event IS 'class=immutable_history; authority=this; question=what did the platform do or get asked to do, one append-only timestamped act — a tool call at a door, an admin act, a knowledge-journal act or a sign-in — the only fallback being /data/events-unwritten.jsonl when a write fails?; retention=audit kinds (admin.*, credential.*, console.*, team.*, bug.*, pkg.download) are kept indefinitely; tool_call and knowledge.* may age out once volume requires it, except a row an evaluation cites';


--
-- Name: COLUMN event.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.id IS 'class=immutable_history; authority=this; question=what is this act''s row identity, the one an evaluation cites as event:<id>?';


--
-- Name: COLUMN event.ts; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.ts IS 'class=immutable_history; authority=this; question=when did this act happen, one row per act and no update?';


--
-- Name: COLUMN event.kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.kind IS 'class=immutable_history; authority=this; question=what kind of act this is, from an open dot-separated vocabulary of lower-case words such as tool_call, knowledge.search or team.archive?';


--
-- Name: COLUMN event.subject; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.subject IS 'class=immutable_history; authority=this; question=what is this act about — the raw <door>:<tool> for a tool_call, a node or bug id elsewhere, or the raw query text for knowledge.search, kept deliberately although a tool call may not record the text it was asked?';


--
-- Name: COLUMN event.detail; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.detail IS 'class=immutable_history; authority=this; question=what open extra payload this act carries — the caller hash, client, argument names, ids, shapes and step_sha — now that run has moved to session and the ms and bytes keys have backfilled duration_ms and response_bytes?';


--
-- Name: COLUMN event.ok; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.ok IS 'class=immutable_history; authority=this; question=did the call work, in the platform''s own terms rather than as a transport status, since an mcp tool that refuses answers http 200 with error: in its text, and every tool_call row must carry it?';


--
-- Name: COLUMN event.refusal; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.refusal IS 'class=immutable_history; authority=this; question=what refusal sentence the platform returned, redacted and capped, when the call did not work?';


--
-- Name: COLUMN event.run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.run_id IS 'class=relation; authority=this; question=which skill_run groups this event, stamped in the same transaction as the event once the matching run identity is created or found and never timer-backfilled?';


--
-- Name: COLUMN event.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.team_id IS 'class=relation; authority=this; question=which team this act belongs to, the composite keys to initiative and skill_run proving they share that team, null only where the team itself is gone?';


--
-- Name: COLUMN event.duration_ms; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.duration_ms IS 'class=immutable_history; authority=this; question=how long the request took, null before 2026-09-14 13:06 where the latency sat in detail.ms until it was backfilled here?';


--
-- Name: COLUMN event.request_bytes; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.request_bytes IS 'class=immutable_history; authority=this; question=how large the request body was, as content-length, null on rows written before measurement began on 2026-09-14 13:06?';


--
-- Name: COLUMN event.response_bytes; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.response_bytes IS 'class=immutable_history; authority=this; question=how large the response body was, null before 2026-09-14 13:06 where detail.bytes stood in for it until the backfill?';


--
-- Name: COLUMN event.batched; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.batched IS 'class=immutable_history; authority=this; question=does this row share one json-rpc batch''s latency and size with the other calls in it, so that a percentile reader must drop it — a real protocol case no client has sent yet, so every row is false?';


--
-- Name: COLUMN event.plugin; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.plugin IS 'class=immutable_history; authority=this; question=which plugin''s door served this call, a deliberate snapshot never resolved from flow_install or the x-zz-client header and null when no plugin door served it, although the 157 sdlc rows of 09-14 to 09-16 came from an older skill-based rule through zz.plugin_version_skill and no row records which rule stamped it?';


--
-- Name: COLUMN event.plugin_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.plugin_version IS 'class=immutable_history; authority=this; question=which version the door''s own plugin reported in its initialize handshake, never set while plugin is null but not necessarily set while plugin is — 64 rows carry a plugin with no version because the door had not handshaken in that process, and 175 of the values name no zz.plugin_version row?';


--
-- Name: COLUMN event.tool_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.tool_key IS 'class=immutable_history; authority=this; question=what the alias-resolved <door>:<tool> name of this call is, stamped at write so that a row reads as one series across a rename with no further lookup, required on every tool_call row and differing from subject on the 2205 rows renamed since?';


--
-- Name: COLUMN event.refusal_owner; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.refusal_owner IS 'class=immutable_history; authority=this; question=whose refusal this was — guardrail, ours, theirs or other — set only on a call that did not work, and possibly with no refusal text at all, as on the one row whose answer was unreadable?';


--
-- Name: COLUMN event.actor_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.actor_id IS 'class=relation; authority=this; question=which principal did this admin or knowledge-journal act, null on a tool_call, where the old actor text''s empty string became null and every non-empty value resolved?';


--
-- Name: COLUMN event.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.initiative_id IS 'class=relation; authority=this; question=which initiative the caller was working on, carried forward per caller, null when the act belongs to none?';


--
-- Name: COLUMN event.session; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.session IS 'class=immutable_history; authority=this; question=what the caller''s conversation key is — a hash of the caller''s email, client and 45-minute bucket minted in gateway memory, which a gateway restart splits and which groups the events a skill_run is built from?';


--
-- Name: COLUMN event.skill_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.skill_version_id IS 'class=relation; authority=this; question=which skill version the caller was following, resolved at write as the latest released version of the skill the caller last loaded so that a later re-registration cannot move it, null when no skill was loaded?';


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
-- Name: TABLE improvement_run; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.improvement_run IS 'class=immutable_history; authority=this; question=which evaluation run''s plugin-owned findings were chosen as one improvement attempt''s target?';


--
-- Name: COLUMN improvement_run.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.improvement_run.id IS 'class=immutable_history; authority=this; question=what is this attempt''s stable identity, the row its candidates hang from?';


--
-- Name: COLUMN improvement_run.eval_run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.improvement_run.eval_run_id IS 'class=relation; authority=this; question=which evaluation run''s findings seeded it, the run initiative_run resolves the initiative''s newest attempt from?';


--
-- Name: COLUMN improvement_run.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.improvement_run.created_at IS 'class=immutable_history; authority=this; question=when was it opened, the order the initiative''s newest improvement run is taken in?';


--
-- Name: improvement_run_finding; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.improvement_run_finding (
    improvement_run_id uuid NOT NULL,
    finding_id uuid NOT NULL
);


--
-- Name: TABLE improvement_run_finding; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.improvement_run_finding IS 'class=relation; authority=this; question=which findings did one improvement attempt take as its target, the join that makes finding-to-change provenance real rather than prose?';


--
-- Name: COLUMN improvement_run_finding.improvement_run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.improvement_run_finding.improvement_run_id IS 'class=relation; authority=this; question=which improvement attempt targeted this finding?';


--
-- Name: COLUMN improvement_run_finding.finding_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.improvement_run_finding.finding_id IS 'class=relation; authority=this; question=which finding did that attempt take as its target, always a plugin-owned one of the attempt''s own evaluation run?';


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

COMMENT ON TABLE zz.initiative_fact IS 'class=current_state; authority=this; question=which branch facts has this initiative decided, each written once by the stage that decided it and never revised, now that the `_facts.json` copy is retired and the row is the authority?';


--
-- Name: COLUMN initiative_fact.fact; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative_fact.fact IS 'class=current_state; authority=this; question=which named branch fact of this initiative''s flow does this row record?';


--
-- Name: COLUMN initiative_fact.value; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative_fact.value IS 'class=current_state; authority=this; question=what did the deciding stage record this branch fact to be?';


--
-- Name: COLUMN initiative_fact.set_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative_fact.set_at IS 'class=current_state; authority=this; question=when was this branch fact decided?';


--
-- Name: COLUMN initiative_fact.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative_fact.initiative_id IS 'class=relation; authority=this; question=which initiative does this branch fact belong to?';


--
-- Name: initiative_record; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.initiative_record (
    initiative_id uuid NOT NULL,
    stage text NOT NULL,
    id_name text NOT NULL,
    value text NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE initiative_record; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.initiative_record IS 'class=current_state; authority=this; question=which ids did each stage of this initiative mint, latest-wins so a stage that runs again supersedes what it recorded before?';


--
-- Name: COLUMN initiative_record.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative_record.initiative_id IS 'class=relation; authority=this; question=which initiative does this stage record belong to?';


--
-- Name: COLUMN initiative_record.stage; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative_record.stage IS 'class=current_state; authority=this; question=which stage of the flow minted these ids?';


--
-- Name: COLUMN initiative_record.id_name; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative_record.id_name IS 'class=current_state; authority=this; question=which of the ids the stage minted is this, under the name the stage itself gives it?';


--
-- Name: COLUMN initiative_record.value; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative_record.value IS 'class=current_state; authority=this; question=what is the id this stage recorded under that name?';


--
-- Name: COLUMN initiative_record.set_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative_record.set_at IS 'class=current_state; authority=this; question=when did this stage last record this id?';


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
-- Name: TABLE knowledge_node; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.knowledge_node IS 'class=current_state; authority=this; question=which lessons does this shelf currently carry, what does each say, and which have been superseded by which?';


--
-- Name: COLUMN knowledge_node.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.id IS 'class=current_state; authority=this; question=what is this node''s stable identity?';


--
-- Name: COLUMN knowledge_node.kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.kind IS 'class=current_state; authority=this; question=which of the six node kinds is this lesson?';


--
-- Name: COLUMN knowledge_node.lifecycle; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.lifecycle IS 'class=current_state; authority=this; question=does this node still stand, or has it been superseded?';


--
-- Name: COLUMN knowledge_node.title; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.title IS 'class=current_state; authority=this; question=what is this node titled?';


--
-- Name: COLUMN knowledge_node.body; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.body IS 'class=current_state; authority=this; question=what does this lesson say?';


--
-- Name: COLUMN knowledge_node.body_tsv; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.body_tsv IS 'class=projection; authority=zz.knowledge_node.body; question=what does this node''s body look like as the search vector a full-text query matches?; rebuilt_from=body';


--
-- Name: COLUMN knowledge_node.tags; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.tags IS 'class=current_state; authority=this; question=which subjects is this node tagged under?';


--
-- Name: COLUMN knowledge_node.content_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.content_hash IS 'class=current_state; authority=this; question=what hash of this node''s derived fields lets a reindex skip it because nothing it derives has changed?';


--
-- Name: COLUMN knowledge_node.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.created_at IS 'class=current_state; authority=this; question=when was this node minted?';


--
-- Name: COLUMN knowledge_node.updated_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.updated_at IS 'class=current_state; authority=this; question=when did this node last change?';


--
-- Name: COLUMN knowledge_node.analyzer_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.analyzer_version IS 'class=projection; authority=zz.knowledge_node.body; question=which analyzer generation produced this node''s search vector, so a vector from another generation can be rederived?; rebuilt_from=body';


--
-- Name: COLUMN knowledge_node.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.team_id IS 'class=relation; authority=this; question=which shelf does this node belong to?';


--
-- Name: COLUMN knowledge_node.node_ordinal; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.node_ordinal IS 'class=current_state; authority=this; question=which ordinal does this node''s file carry within its shelf?';


--
-- Name: COLUMN knowledge_node.slug; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.slug IS 'class=current_state; authority=this; question=what is this node''s slug in its shelf-local file address?';


--
-- Name: COLUMN knowledge_node.superseded_by_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node.superseded_by_id IS 'class=relation; authority=this; question=which node supersedes this one?';


--
-- Name: knowledge_node_evidence; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.knowledge_node_evidence (
    node_id uuid NOT NULL,
    initiative_id uuid NOT NULL
);


--
-- Name: TABLE knowledge_node_evidence; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.knowledge_node_evidence IS 'class=relation; authority=this; question=which initiatives was this node learned from, including initiatives of a team other than the node''s own shelf, since a citation is not tenant-scoped?';


--
-- Name: COLUMN knowledge_node_evidence.node_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node_evidence.node_id IS 'class=relation; authority=this; question=which node does this learned-from link belong to?';


--
-- Name: COLUMN knowledge_node_evidence.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.knowledge_node_evidence.initiative_id IS 'class=relation; authority=this; question=which initiative was this node learned from?';


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
-- Name: TABLE mcp_oauth_authz; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.mcp_oauth_authz IS 'class=ephemeral; authority=this; question=which authorization code is issued to which client for which person and door, awaiting a single PKCE exchange?; retention=swept by the hourly sweepSessions once expires_at passes, and consumed atomically at the PKCE exchange; the code window is 10 minutes';


--
-- Name: COLUMN mcp_oauth_authz.client_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_authz.client_id IS 'class=relation; authority=this; question=which registered client was this code issued to?';


--
-- Name: COLUMN mcp_oauth_authz.principal_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_authz.principal_id IS 'class=relation; authority=this; question=which person authorized this code?';


--
-- Name: COLUMN mcp_oauth_authz.redirect_uri; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_authz.redirect_uri IS 'class=ephemeral; authority=this; question=which redirect URI is this code bound to?';


--
-- Name: COLUMN mcp_oauth_authz.code_challenge; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_authz.code_challenge IS 'class=ephemeral; authority=this; question=what PKCE S256 challenge must the exchange answer?';


--
-- Name: COLUMN mcp_oauth_authz.resource; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_authz.resource IS 'class=ephemeral; authority=this; question=which MCP door was this code authorized for?';


--
-- Name: COLUMN mcp_oauth_authz.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_authz.created_at IS 'class=ephemeral; authority=this; question=when was this code issued?';


--
-- Name: COLUMN mcp_oauth_authz.code_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_authz.code_hash IS 'class=ephemeral; authority=this; question=what is the sha256 of the authorization code?';


--
-- Name: COLUMN mcp_oauth_authz.expires_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_authz.expires_at IS 'class=ephemeral; authority=this; question=when does this code''s ten-minute window end?';


--
-- Name: COLUMN mcp_oauth_authz.used_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_authz.used_at IS 'class=ephemeral; authority=this; question=when was this code exchanged?';


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
-- Name: TABLE mcp_oauth_client; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.mcp_oauth_client IS 'class=current_state; authority=this; question=which OAuth public client registered itself, and which redirect URIs may it receive codes at?; retention=durable until explicitly revoked by client_revoke: an open registration endpoint makes the table unbounded, and inactivity alone never deletes a registration';


--
-- Name: COLUMN mcp_oauth_client.client_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_client.client_id IS 'class=current_state; authority=this; question=what is this client''s public identity?';


--
-- Name: COLUMN mcp_oauth_client.redirect_uris; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_client.redirect_uris IS 'class=current_state; authority=this; question=which redirect URIs may this client receive a code at?';


--
-- Name: COLUMN mcp_oauth_client.name; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_client.name IS 'class=current_state; authority=this; question=what name did this client declare for itself?';


--
-- Name: COLUMN mcp_oauth_client.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_client.created_at IS 'class=current_state; authority=this; question=when did this client register?';


--
-- Name: COLUMN mcp_oauth_client.revoked_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.mcp_oauth_client.revoked_at IS 'class=current_state; authority=this; question=when was this client''s registration revoked?';


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
-- Name: TABLE membership; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.membership IS 'class=relation; authority=this; question=which person belongs to which team, in what team role, and who put them there?';


--
-- Name: COLUMN membership.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.membership.team_id IS 'class=relation; authority=this; question=which team does this membership join?';


--
-- Name: COLUMN membership.principal_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.membership.principal_id IS 'class=relation; authority=this; question=which person does this membership join?';


--
-- Name: COLUMN membership.role; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.membership.role IS 'class=relation; authority=this; question=what team authority does this person hold in this team?';


--
-- Name: COLUMN membership.added_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.membership.added_by IS 'class=relation; authority=this; question=which principal added this person to this team?';


--
-- Name: COLUMN membership.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.membership.created_at IS 'class=relation; authority=this; question=when was this person added to this team?';


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
-- Name: TABLE model_call; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.model_call IS 'class=immutable_history; authority=this; question=what one outbound model request the platform itself made cost and returned — which purpose, which model, how many tokens, how long, and whether it worked?; retention=kept indefinitely; it is the provenance an assessment names, and a row an evaluation cites is never purged';


--
-- Name: COLUMN model_call.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.id IS 'class=immutable_history; authority=this; question=what this call''s identity is, the one an assessment names as the call that produced its answer?';


--
-- Name: COLUMN model_call.ts; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.ts IS 'class=immutable_history; authority=this; question=when this call was made?';


--
-- Name: COLUMN model_call.purpose; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.purpose IS 'class=immutable_history; authority=this; question=which caller path made this call — typed-judge, failure-discover, or the historic plugin-judge — from a small code-owned vocabulary?';


--
-- Name: COLUMN model_call.model; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.model IS 'class=immutable_history; authority=this; question=which model was asked for, spelled <provider>/<model> so that one column carries one spelling?';


--
-- Name: COLUMN model_call.input_tokens; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.input_tokens IS 'class=immutable_history; authority=this; question=how many input tokens the provider reported, null when it reported none?';


--
-- Name: COLUMN model_call.output_tokens; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.output_tokens IS 'class=immutable_history; authority=this; question=how many output tokens the provider reported, null when it reported none?';


--
-- Name: COLUMN model_call.cache_read_tokens; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.cache_read_tokens IS 'class=immutable_history; authority=this; question=how many input tokens the provider served from cache, null when it reported no cache figure and 0 when it reported a cache of zero?';


--
-- Name: COLUMN model_call.duration_ms; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.duration_ms IS 'class=immutable_history; authority=this; question=how long the call took, never null even when it failed?';


--
-- Name: COLUMN model_call.ok; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.ok IS 'class=immutable_history; authority=this; question=whether the call succeeded, never null even when the model never answered?';


--
-- Name: COLUMN model_call.attempts; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.attempts IS 'class=immutable_history; authority=this; question=how many attempts the typed service needed inside one ask — a real retry loop that no row has exercised yet, so every row is 1, while the judge path deliberately makes one attempt?';


--
-- Name: COLUMN model_call.error; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.model_call.error IS 'class=immutable_history; authority=this; question=why the call failed, set only when it did not succeed and kept for a transport failure that left no assessment behind, since a failure that produced an answer already carries its reason there?';


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
-- Name: TABLE passkey; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.passkey IS 'class=current_state; authority=this; question=which registered authenticator proves which person at the browser door?';


--
-- Name: COLUMN passkey.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey.id IS 'class=current_state; authority=this; question=what is this WebAuthn credential id?';


--
-- Name: COLUMN passkey.principal_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey.principal_id IS 'class=relation; authority=this; question=which person owns this authenticator?';


--
-- Name: COLUMN passkey.public_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey.public_key IS 'class=current_state; authority=this; question=what COSE public key verifies this authenticator''s assertions?';


--
-- Name: COLUMN passkey.counter; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey.counter IS 'class=current_state; authority=this; question=what signature counter has this authenticator reached?';


--
-- Name: COLUMN passkey.transports; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey.transports IS 'class=current_state; authority=this; question=how is this authenticator reached?';


--
-- Name: COLUMN passkey.label; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey.label IS 'class=current_state; authority=this; question=what device name is this authenticator shown under?';


--
-- Name: COLUMN passkey.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey.created_at IS 'class=current_state; authority=this; question=when was this device enrolled?';


--
-- Name: COLUMN passkey.last_used_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey.last_used_at IS 'class=current_state; authority=this; question=when did this device last sign in?';


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
-- Name: TABLE passkey_challenge; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.passkey_challenge IS 'class=ephemeral; authority=this; question=which WebAuthn challenge has this server issued to one browser, awaiting the signed answer to it?; retention=swept by the hourly sweepSessions once expires_at passes, and consumed by the single-use delete at the ceremony; the challenge window is 5 minutes';


--
-- Name: COLUMN passkey_challenge.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_challenge.id IS 'class=ephemeral; authority=this; question=what ceremony handle is carried in the zz_ceremony cookie?';


--
-- Name: COLUMN passkey_challenge.challenge; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_challenge.challenge IS 'class=ephemeral; authority=this; question=what value must the authenticator sign?';


--
-- Name: COLUMN passkey_challenge.kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_challenge.kind IS 'class=ephemeral; authority=this; question=is this challenge a registration or a login?';


--
-- Name: COLUMN passkey_challenge.principal_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_challenge.principal_id IS 'class=relation; authority=this; question=which person is this registration challenge for?';


--
-- Name: COLUMN passkey_challenge.redirect_to; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_challenge.redirect_to IS 'class=ephemeral; authority=this; question=where does this ceremony land after sign-in?';


--
-- Name: COLUMN passkey_challenge.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_challenge.created_at IS 'class=ephemeral; authority=this; question=when was this challenge issued?';


--
-- Name: COLUMN passkey_challenge.expires_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_challenge.expires_at IS 'class=ephemeral; authority=this; question=when does this challenge''s five-minute window end?';


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
-- Name: TABLE passkey_enrolment; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.passkey_enrolment IS 'class=ephemeral; authority=this; question=which single-use, expiring invitation lets one named principal register a passkey?; retention=swept 7 days after use or expiry, within 14 days of issue; the durable audit is the admin.issue_enrolment event';


--
-- Name: COLUMN passkey_enrolment.token_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_enrolment.token_hash IS 'class=ephemeral; authority=this; question=what is the sha256 of this invitation link''s secret?';


--
-- Name: COLUMN passkey_enrolment.principal_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_enrolment.principal_id IS 'class=relation; authority=this; question=which person may enrol with this link?';


--
-- Name: COLUMN passkey_enrolment.expires_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_enrolment.expires_at IS 'class=ephemeral; authority=this; question=when does this invitation''s seven-day window end?';


--
-- Name: COLUMN passkey_enrolment.used_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.passkey_enrolment.used_at IS 'class=ephemeral; authority=this; question=when was this invitation spent?';


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
-- Name: TABLE pat; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.pat IS 'class=current_state; authority=this; question=which bearer credential does a program hold to act as a person, confined to which team and client, with what lifetime and revocation?; retention=kept as durable provenance until explicitly revoked or expired; a revoked row is never deleted, because pat_list and client_revoke read it';


--
-- Name: COLUMN pat.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.id IS 'class=current_state; authority=this; question=what handle lists and revokes this token?';


--
-- Name: COLUMN pat.principal_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.principal_id IS 'class=relation; authority=this; question=whose authority does this token carry?';


--
-- Name: COLUMN pat.token_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.token_hash IS 'class=current_state; authority=this; question=what is the sha256 of this token''s bearer secret?';


--
-- Name: COLUMN pat.label; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.label IS 'class=current_state; authority=this; question=what purpose does this token serve, and what is it displayed as?';


--
-- Name: COLUMN pat.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.team_id IS 'class=relation; authority=this; question=which team is this token confined to, if any?';


--
-- Name: COLUMN pat.expires_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.expires_at IS 'class=current_state; authority=this; question=when does this token stop working?';


--
-- Name: COLUMN pat.revoked_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.revoked_at IS 'class=current_state; authority=this; question=when was this token revoked?';


--
-- Name: COLUMN pat.last_used_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.last_used_at IS 'class=current_state; authority=this; question=when did this token last authenticate?';


--
-- Name: COLUMN pat.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.created_at IS 'class=current_state; authority=this; question=when was this token issued?';


--
-- Name: COLUMN pat.oauth_client_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.pat.oauth_client_id IS 'class=relation; authority=this; question=which registered OAuth client was this token minted for?';


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
-- Name: TABLE plugin; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.plugin IS 'class=current_state; authority=this; question=which plugins the platform knows, whether each is ours or a third party''s, and which team maintains it?';


--
-- Name: COLUMN plugin.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin.id IS 'class=current_state; authority=this; question=what is this plugin''s stable identity, the row its versions, protocol versions and release authority hang from?';


--
-- Name: COLUMN plugin.name; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin.name IS 'class=current_state; authority=this; question=what is this plugin''s unique name, the external address that IDENTIFY and the console resolve through?';


--
-- Name: COLUMN plugin.origin; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin.origin IS 'class=current_state; authority=this; question=is this plugin one the platform released or a third-party capture, the fact that decides which registration path may write it?';


--
-- Name: COLUMN plugin.owner_team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin.owner_team_id IS 'class=relation; authority=this; question=which team maintains this plugin, a display fact that grants no release authority?';


--
-- Name: plugin_release_owner; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin_release_owner (
    plugin_id uuid NOT NULL,
    team_id uuid NOT NULL
);


--
-- Name: TABLE plugin_release_owner; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.plugin_release_owner IS 'class=relation; authority=this; question=which teams'' members may approve and apply a release of which plugin?';


--
-- Name: COLUMN plugin_release_owner.plugin_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_release_owner.plugin_id IS 'class=relation; authority=this; question=which plugin does this release authority belong to?';


--
-- Name: COLUMN plugin_release_owner.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_release_owner.team_id IS 'class=relation; authority=this; question=which team holds this plugin''s release authority?';


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
-- Name: TABLE plugin_tool; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.plugin_tool IS 'class=immutable_history; authority=this; question=which MCP tool names, and on which door, did this plugin version serve, captured at boot so it cannot be rebuilt without booting that build again?';


--
-- Name: COLUMN plugin_tool.plugin_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_tool.plugin_version_id IS 'class=relation; authority=this; question=which plugin version served this tool?';


--
-- Name: COLUMN plugin_tool.name; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_tool.name IS 'class=immutable_history; authority=this; question=what tool name did this plugin version serve?';


--
-- Name: COLUMN plugin_tool.door; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_tool.door IS 'class=immutable_history; authority=this; question=which door served this tool, a fact that stays true history after a door moves elsewhere?';


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
-- Name: TABLE plugin_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.plugin_version IS 'class=immutable_history; authority=this; question=which plugin was released as which version with which content digest, written once and never rewritten?';


--
-- Name: COLUMN plugin_version.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version.id IS 'class=immutable_history; authority=this; question=which released plugin version do its tools, skill memberships, observation snapshots and evaluation subjects hang from?';


--
-- Name: COLUMN plugin_version.plugin_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version.plugin_id IS 'class=relation; authority=this; question=which plugin was this version released from?';


--
-- Name: COLUMN plugin_version.version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version.version IS 'class=immutable_history; authority=this; question=which version did the plugin declare for this release?';


--
-- Name: COLUMN plugin_version.digest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version.digest IS 'class=immutable_history; authority=this; question=what content digest did the release vouch for these exact bytes, the identity an evaluation subject is compared against?';


--
-- Name: COLUMN plugin_version.released_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version.released_at IS 'class=immutable_history; authority=this; question=when was this version first registered, the release order that version strings cannot give once a plugin has been renumbered?';


--
-- Name: COLUMN plugin_version.component_manifest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version.component_manifest IS 'class=immutable_history; authority=this; question=which components made up this version of a third-party capture, null for a catalog release?';


--
-- Name: COLUMN plugin_version.source_locator; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version.source_locator IS 'class=immutable_history; authority=this; question=where was this third-party capture taken from, null for a catalog release?';


--
-- Name: COLUMN plugin_version.tree_digest; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version.tree_digest IS 'class=immutable_history; authority=this; question=what digest did the captured source tree have, null for a catalog release?';


--
-- Name: COLUMN plugin_version.resolved_commit; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version.resolved_commit IS 'class=immutable_history; authority=this; question=which commit was the captured source resolved to, null for a catalog release?';


--
-- Name: plugin_version_skill; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin_version_skill (
    plugin_version_id uuid NOT NULL,
    skill_version_id uuid NOT NULL,
    skill_id uuid NOT NULL
);


--
-- Name: TABLE plugin_version_skill; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.plugin_version_skill IS 'class=relation; authority=this; question=which skill version did each plugin version ship?';


--
-- Name: COLUMN plugin_version_skill.plugin_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version_skill.plugin_version_id IS 'class=relation; authority=this; question=which plugin version shipped this skill version?';


--
-- Name: COLUMN plugin_version_skill.skill_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version_skill.skill_version_id IS 'class=relation; authority=this; question=which version of the skill did this plugin version ship?';


--
-- Name: COLUMN plugin_version_skill.skill_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.plugin_version_skill.skill_id IS 'class=relation; authority=this; question=which skill does this membership bind, the key column that stops one plugin version binding two versions of the same skill?';


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
-- Name: TABLE principal; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.principal IS 'class=current_state; authority=this; question=who is known to the platform, with what platform authority, whether they may act, and which team they chose to act for?';


--
-- Name: COLUMN principal.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.principal.id IS 'class=current_state; authority=this; question=what is this person''s stable identity?';


--
-- Name: COLUMN principal.email; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.principal.email IS 'class=current_state; authority=this; question=what login address resolves this person at every door?';


--
-- Name: COLUMN principal.display_name; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.principal.display_name IS 'class=current_state; authority=this; question=what human name is this person shown under?';


--
-- Name: COLUMN principal.role; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.principal.role IS 'class=current_state; authority=this; question=what platform-wide authority does this person hold?';


--
-- Name: COLUMN principal.status; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.principal.status IS 'class=current_state; authority=this; question=may this person act at all?';


--
-- Name: COLUMN principal.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.principal.created_at IS 'class=current_state; authority=this; question=when was this person added?';


--
-- Name: COLUMN principal.active_team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.principal.active_team_id IS 'class=relation; authority=this; question=which team has this person chosen to act for?';


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
-- Name: TABLE release_attempt; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.release_attempt IS 'class=state_machine; authority=this; question=what became of one attempt to promote one candidate — applied, refused, failed or rolled back — and did real use after the release establish it?; transitions=prepared->applying,applying->released,applying->failed,prepared->refused,released->rolled_back';


--
-- Name: COLUMN release_attempt.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.id IS 'class=state_machine; authority=this; question=what is this attempt''s stable identity, the row its required owners, audit and verdict hang from?';


--
-- Name: COLUMN release_attempt.candidate_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.candidate_id IS 'class=relation; authority=this; question=which candidate it releases, the parent the console''s newest-attempt query orders by?';


--
-- Name: COLUMN release_attempt.status; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.status IS 'class=state_machine; authority=this; question=where does it stand — prepared, applying, released, refused, failed or rolled back — the field every reader of the promotion boundary gates on?';


--
-- Name: COLUMN release_attempt.released_plugin_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.released_plugin_version_id IS 'class=relation; authority=this; question=which released plugin version it published, never null exactly when the status is released or rolled_back?';


--
-- Name: COLUMN release_attempt.release_ref; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.release_ref IS 'class=state_machine; authority=this; question=which 40-hex commit the release tag names, null until a release lands?';


--
-- Name: COLUMN release_attempt.verification; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.verification IS 'class=state_machine; authority=this; question=what evidence does the verdict rest on — {post_release_runs, released_eval_run_id, released_overall, base_eval_run_id, base_overall, delta, regression_band, guardrail_status} — null until the released subject has enough real runs and an evaluation to judge, the verdict itself being the verdict column and when it landed being verified_at?';


--
-- Name: COLUMN release_attempt.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.created_at IS 'class=state_machine; authority=this; question=when was it prepared, the order the console prints attempts in?';


--
-- Name: COLUMN release_attempt.reason; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.reason IS 'class=state_machine; authority=this; question=why did this attempt end as it did — releaseDecision''s own reason on a refusal, the failing command''s output tail (release_record) on a failure, the operator''s reason on a rollback, or the accepted override (--reconcile --accept-tag-without-candidate-commit) on a reconciled release — null for prepared and applying, and for a release proved without an override?';


--
-- Name: COLUMN release_attempt.plugin_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.plugin_id IS 'class=relation; authority=this; question=which plugin this attempt releases — the base subject''s own plugin, written by release_prepare — the column keying the index that allows at most one applying attempt per plugin?';


--
-- Name: COLUMN release_attempt.applying_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.applying_at IS 'class=state_machine; authority=this; question=when did release_apply move it to applying, an attempt still applying long after the CLI''s own gate and release timeouts being stale and named by release_apply for reconciliation?';


--
-- Name: COLUMN release_attempt.verdict; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.verdict IS 'class=state_machine; authority=this; question=what did the post-release check decide — established, rolled_back or not_established — null until real use of the released version has been judged?';


--
-- Name: COLUMN release_attempt.verified_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.verified_at IS 'class=state_machine; authority=this; question=when was that verdict recorded?';


--
-- Name: COLUMN release_attempt.applied_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.applied_by IS 'class=state_machine; authority=this; question=which principal''s release_apply moved it to applying, since release_record and release_verify accept that principal or a member of a required owner team and nobody else?';


--
-- Name: release_attempt_owner; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.release_attempt_owner (
    release_attempt_id uuid NOT NULL,
    team_id uuid NOT NULL
);


--
-- Name: TABLE release_attempt_owner; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.release_attempt_owner IS 'class=relation; authority=this; question=which teams'' members must approve and apply a release attempt before it may cross the promotion boundary?';


--
-- Name: COLUMN release_attempt_owner.release_attempt_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt_owner.release_attempt_id IS 'class=relation; authority=this; question=which release attempt does this required-owner row gate?';


--
-- Name: COLUMN release_attempt_owner.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt_owner.team_id IS 'class=relation; authority=this; question=which team''s members may approve that attempt, resolved live from the base subject''s own release owners when it was prepared?';



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
-- Name: TABLE skill; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.skill IS 'class=current_state; authority=this; question=which skill names has the catalog ever shipped, which flow each is a step of, and which are no longer in the catalog?';


--
-- Name: COLUMN skill.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill.id IS 'class=current_state; authority=this; question=what is this skill''s stable identity, the row its versions and every attribution through them hang from?';


--
-- Name: COLUMN skill.name; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill.name IS 'class=current_state; authority=this; question=what is this skill''s catalog name, the external address that is unique across the whole catalog?';


--
-- Name: COLUMN skill.flow; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill.flow IS 'class=current_state; authority=this; question=which flow manifest names this skill as one of its steps, null when it is a plugin skill rather than a flow step, and the fact a subject''s profile filters on to exclude a flow''s own skills?';


--
-- Name: COLUMN skill.retired; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill.retired IS 'class=current_state; authority=this; question=is this skill no longer in the catalog, a flag whose identity row survives because runs and documents still attribute to its versions?';


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
-- Name: TABLE skill_run; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.skill_run IS 'class=current_state; authority=this; question=what has one caller conversation done with one skill version inside one initiative — how many calls, how many refusals, how much response body, and from when to when?; retention=follows event: never pruned on its own, and once raw telemetry ages out the summary stays the durable answer for its window';


--
-- Name: COLUMN skill_run.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.id IS 'class=current_state; authority=this; question=what this run''s stable identity is, the one an evaluation cites as run:<uuid> and an event points at as its run_id?';


--
-- Name: COLUMN skill_run.initiative_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.initiative_id IS 'class=relation; authority=this; question=which initiative this run happened in, null for the 96 runs whose calls belonged to no initiative?';


--
-- Name: COLUMN skill_run.skill_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.skill_version_id IS 'class=relation; authority=this; question=which skill version the run used, time-bound to the version current at the events it groups, never null?';


--
-- Name: COLUMN skill_run.session; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.session IS 'class=current_state; authority=this; question=what conversation key this run groups, the same key its events carry, never the empty string?';


--
-- Name: COLUMN skill_run.calls; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.calls IS 'class=current_state; authority=this; question=how many events this run holds, maintained from the run''s own events and changed only when the aggregate changes?';


--
-- Name: COLUMN skill_run.refusals; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.refusals IS 'class=current_state; authority=this; question=how many of this run''s events did not work, maintained from the run''s own events and never more than its calls?';


--
-- Name: COLUMN skill_run.bytes_total; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.bytes_total IS 'class=current_state; authority=this; question=what the sum of response_bytes over the run''s events is, null when no event in the run was measured and distinct from 0, which means measured and empty, while the zeros written before migration 051 are ambiguous and were deliberately not converted?';


--
-- Name: COLUMN skill_run.started_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.started_at IS 'class=current_state; authority=this; question=when this run''s first event happened, the min of its events'' ts?';


--
-- Name: COLUMN skill_run.ended_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.ended_at IS 'class=current_state; authority=this; question=when this run''s last event happened, the max of its ts, never null so that a run always reads as closed?';


--
-- Name: COLUMN skill_run.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.team_id IS 'class=relation; authority=this; question=which team owns this run, taken from its events so that the 96 initiative-less runs are visible in team scope too?';


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
-- Name: TABLE skill_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.skill_version IS 'class=immutable_history; authority=this; question=what exact bytes of a skill were registered as which version, the only surviving record of them because git history is deliberately destroyed?';


--
-- Name: COLUMN skill_version.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_version.id IS 'class=immutable_history; authority=this; question=which released skill version does a run, a document or a plugin membership attribute to?';


--
-- Name: COLUMN skill_version.skill_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_version.skill_id IS 'class=relation; authority=this; question=which skill does this released version belong to?';


--
-- Name: COLUMN skill_version.version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_version.version IS 'class=immutable_history; authority=this; question=which version string did the skill declare when this row was registered?';


--
-- Name: COLUMN skill_version.content_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_version.content_hash IS 'class=immutable_history; authority=this; question=what is the whole-file identity of the released SKILL.md, where a legacy <size>-<hex> value predates the sha256 format, is already baked into a subject digest, and so must never be rewritten even though the sha256 check binds only later rows?';


--
-- Name: COLUMN skill_version.released_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_version.released_at IS 'class=immutable_history; authority=this; question=when was this version first registered, the only ''live from'' anchor for the bytes it names?';


--
-- Name: COLUMN skill_version.body_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_version.body_hash IS 'class=immutable_history; authority=this; question=what is the sha256 of the SKILL.md below its frontmatter, so equal hashes say a version bump changed only the frontmatter, and no reader can recompute it once git history is gone?';


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
-- Name: TABLE team; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.team IS 'class=current_state; authority=this; question=what tenant exists under which slug, is it live or archived, and who created it?';


--
-- Name: COLUMN team.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.team.id IS 'class=current_state; authority=this; question=what is this tenant''s stable identity?';


--
-- Name: COLUMN team.slug; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.team.slug IS 'class=current_state; authority=this; question=what is this team''s external address, the slug that names it in a URL and in every document path?';


--
-- Name: COLUMN team.name; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.team.name IS 'class=current_state; authority=this; question=what display name is this team shown under?';


--
-- Name: COLUMN team.status; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.team.status IS 'class=current_state; authority=this; question=is this team live or archived?';


--
-- Name: COLUMN team.created_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.team.created_by IS 'class=current_state; authority=this; question=which principal created this tenant?';


--
-- Name: COLUMN team.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.team.created_at IS 'class=current_state; authority=this; question=when was this tenant created?';


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
-- Name: doc doc_current_revision_required; Type: CHECK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE zz.doc
    ADD CONSTRAINT doc_current_revision_required CHECK ((((approved_revision IS NULL) OR (approved_revision <= current_revision)) AND ((status = 'approved'::text) = ((approved_revision IS NOT NULL) AND (approved_revision = current_revision))))) NOT VALID;


--
-- Name: doc doc_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_pkey PRIMARY KEY (id);


--
-- Name: doc_revision doc_revision_doc_id_revision_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_revision
    ADD CONSTRAINT doc_revision_doc_id_revision_key UNIQUE (doc_id, revision);


--
-- Name: doc_revision doc_revision_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_revision
    ADD CONSTRAINT doc_revision_pkey PRIMARY KEY (doc_id, revision);


--
-- Name: eval_assessment eval_assessment_document_revision; Type: CHECK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE zz.eval_assessment
    ADD CONSTRAINT eval_assessment_document_revision CHECK (((subject_kind <> 'document'::text) OR (doc_revision IS NOT NULL))) NOT VALID;


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
-- Name: eval_protocol_version eval_protocol_version_affirmed_revision; Type: CHECK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_affirmed_revision CHECK (((affirmed_at IS NULL) OR (approved_doc_revision IS NOT NULL))) NOT VALID;


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
-- Name: initiative_record initiative_record_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative_record
    ADD CONSTRAINT initiative_record_pkey PRIMARY KEY (initiative_id, stage, id_name);


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
-- Name: doc_id_unique; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX doc_id_unique ON zz.doc USING btree (id);


--
-- Name: doc_link_unique; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX doc_link_unique ON zz.doc_link USING btree (from_doc_id, from_revision, to_doc_id, to_revision, kind) NULLS NOT DISTINCT;


--
-- Name: doc_tags; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_tags ON zz.doc USING gin (tags);


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
-- Name: doc doc_id_approved_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_id_approved_revision_fkey FOREIGN KEY (id, approved_revision) REFERENCES zz.doc_revision(doc_id, revision);


--
-- Name: doc doc_id_current_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_id_current_revision_fkey FOREIGN KEY (id, current_revision) REFERENCES zz.doc_revision(doc_id, revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: doc doc_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE CASCADE;


--
-- Name: doc_link doc_link_from_doc_id_from_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_link
    ADD CONSTRAINT doc_link_from_doc_id_from_revision_fkey FOREIGN KEY (from_doc_id, from_revision) REFERENCES zz.doc_revision(doc_id, revision) ON DELETE CASCADE;


--
-- Name: doc_link doc_link_to_doc_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_link
    ADD CONSTRAINT doc_link_to_doc_id_fkey FOREIGN KEY (to_doc_id) REFERENCES zz.doc(id) ON DELETE CASCADE;


--
-- Name: doc_link doc_link_to_doc_id_to_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_link
    ADD CONSTRAINT doc_link_to_doc_id_to_revision_fkey FOREIGN KEY (to_doc_id, to_revision) REFERENCES zz.doc_revision(doc_id, revision) ON DELETE CASCADE;


--
-- Name: doc_revision doc_revision_doc_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_revision
    ADD CONSTRAINT doc_revision_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES zz.doc(id) ON DELETE CASCADE;


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
-- Name: eval_assessment eval_assessment_doc_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_doc_revision_fkey FOREIGN KEY (doc_id, doc_revision) REFERENCES zz.doc_revision(doc_id, revision);


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
-- Name: eval_protocol_version eval_protocol_version_approved_doc_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_approved_doc_revision_fkey FOREIGN KEY (approved_doc_id, approved_doc_revision) REFERENCES zz.doc_revision(doc_id, revision);


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
-- Name: initiative_record initiative_record_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative_record
    ADD CONSTRAINT initiative_record_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE CASCADE;


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


-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Absorbed: 002_store_carry_repair.sql (released as 0.88.0, folded after verification)
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- The carry (Phase 6) kept every store file as a `doc` row, which is why its own rehearsal
-- criterion was "doc's rows carried at the same count". Two kinds of row it carried cannot stand
-- in the target's shape, and both are REPAIRS of the carry's own output rather than a change to
-- what the spec asks for:
--
--   1. A `_versions/<stem>.v<N>.md` row is the frozen copy of revision N of `<stem>.md`, and the
--      carry ALSO wrote that revision as a `doc_revision` row. The bytes are therefore held twice
--      — verified equal on every one of the 336 rows before this file was written — and the
--      duplicate has no revision of its own, so it carries `status = 'approved'` with
--      `approved_revision` null: it is one of the rows `doc_current_revision_required` refuses.
--      It is deleted here, and its delete is GUARDED on the duplication still holding: a row
--      whose bytes are NOT in its parent's revision is left exactly where it is.
--
--   2. `doc.content_hash` is a declared projection of `doc_revision[current_revision]`, and every
--      live write keeps it equal to that row's hash. The carry wrote the OLD store's value
--      instead — the hash of the JSON projection `indexDoc` built, a claim about re-deriving a row
--      that no longer exists (scripts/store-migration/model.ts said so at the time). 1,225 rows
--      disagreed with their own current revision. Backfilled here, so the projection is true and
--      the column means one thing.
--
-- With both done, every row satisfies `doc_current_revision_required` and the constraint is
-- VALIDATED — the target declares it as a check, not as `not valid`, and a deployment whose rows
-- satisfy it can enforce it from here on.
--
-- DELIBERATE: the delete's precondition is repeated as a query in the rehearsal's always-run
-- invariants (`scripts/rehearse/invariants.ts`) rather than as a join beside this file. A join
-- would have to name `_versions/` in a `.ts` file, and `checks/store-retired.ts` refuses exactly
-- that — rightly, since the rule it enforces is "no code reaches the store", and a document row
-- that survived this file is already reported by the invariant on
-- `doc_current_revision_required`: a leftover frozen copy is approved with no approved revision.
--
-- DELIBERATE: no transaction control in this file. The runner applies it and its ledger row in
-- one transaction (services/gateway/src/db.ts), and the rehearsal's join expectations rely on the
-- ledger's `applied_at` being the migration's own `now()`.

-- 1. The frozen copies the carry carried twice.
delete from zz.doc v
 where v.path like '\_versions/%'
   and exists (
     select 1
       from zz.doc parent
       join zz.doc_revision r on r.doc_id = parent.id
      where parent.initiative_id = v.initiative_id
        and parent.path = regexp_replace(v.path, '^_versions/(.+)\.v\d+\.md$', '\1') || '.md'
        and r.revision = (regexp_replace(v.path, '^_versions/.+\.v(\d+)\.md$', '\1'))::int
        and r.content_state = 'retained'
        and r.body = v.body);

-- 2. The projection the carry left describing a world that is gone.
update zz.doc d
   set content_hash = r.content_hash
  from zz.doc_revision r
 where r.doc_id = d.id
   and r.revision = d.current_revision
   and d.content_hash is distinct from r.content_hash;

-- 3. Every row satisfies it now, so it is enforced rather than merely declared.
alter table zz.doc validate constraint doc_current_revision_required;
